import { RESTDataSource } from '@apollo/datasource-rest';
import { getKeycloakToken } from '../utils/auth.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('charting-api');

/**
 * ChartingAPI — datasource for sapphire-charting-api.
 *
 * Provides temperature trend data for the temperatureData GraphQL query and
 * raw temperature record export for the temperatureExport GraphQL query.
 * Propagates W3C traceparent header on every outbound request so distributed
 * traces span from the BFF into the charting service.
 */
export class ChartingAPI extends RESTDataSource {
  baseURL = process.env.CHARTING_API_BASE_URL || 'http://localhost:8080';

  /**
   * Override willSendRequest to attach Keycloak Bearer token and
   * W3C traceparent header to all outbound requests.
   */
  async willSendRequest(path, request) {
    try {
      console.info(`[ChartingAPI] Preparing request to: ${this.baseURL}${path}`);
      const token = await getKeycloakToken();
      request.headers['Authorization'] = `Bearer ${token}`;

      // Propagate active trace context via W3C traceparent header.
      const activeSpan = trace.getActiveSpan();
      if (activeSpan) {
        const ctx = activeSpan.spanContext();
        // Format: 00-<traceId>-<spanId>-<flags>
        const traceFlags = ctx.traceFlags.toString(16).padStart(2, '0');
        request.headers['traceparent'] = `00-${ctx.traceId}-${ctx.spanId}-${traceFlags}`;
      }
    } catch (error) {
      console.error('[ChartingAPI] Failed to prepare request:', error);
      throw new Error('Authentication failed');
    }
  }

  /**
   * Fetch temperature trend summaries (min/max/avg) for a user.
   *
   * Maps to GET /api/charts/temperatures on sapphire-charting-api.
   * Returns an empty array when the upstream responds with 204 No Content.
   *
   * @param {string} userId       - User identifier (email / UUID).
   * @param {string} granularity  - Aggregation bucket: "day" | "week" | "month".
   * @param {string} dateFrom     - ISO-8601 start of the requested window.
   * @param {string} dateTo       - ISO-8601 end of the requested window.
   * @param {string|null} deviceSource - Optional device source filter.
   * @returns {Promise<Array>} Array of TemperatureTrendSummary objects, possibly empty.
   */
  async getTemperatureTrend(userId, granularity, dateFrom, dateTo, deviceSource) {
    return tracer.startActiveSpan('ChartingAPI.getTemperatureTrend', async (span) => {
      try {
        span.setAttribute('user.id', userId);
        span.setAttribute('chart.granularity', granularity);
        span.setAttribute('chart.dateFrom', dateFrom);
        span.setAttribute('chart.dateTo', dateTo);
        if (deviceSource) {
          span.setAttribute('chart.deviceSource', deviceSource);
        }

        const params = new URLSearchParams({ userId, granularity, dateFrom, dateTo });
        if (deviceSource) {
          params.set('deviceSource', deviceSource);
        }

        console.info('[ChartingAPI] getTemperatureTrend - fetching', {
          userId,
          granularity,
          dateFrom,
          dateTo,
          deviceSource: deviceSource || null,
        });

        let data;
        try {
          data = await this.get(`/api/charts/temperatures?${params.toString()}`);
        } catch (fetchErr) {
          // Apollo RESTDataSource throws for non-2xx responses.
          // A 204 results in an empty body which resolves to undefined/null;
          // guard here in case the client throws for 204.
          if (fetchErr.extensions?.response?.status === 204) {
            console.info('[ChartingAPI] getTemperatureTrend - 204 No Content, returning empty array');
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }
          throw fetchErr;
        }

        // Handle explicit null/undefined body (204 without throw)
        if (data == null) {
          console.info('[ChartingAPI] getTemperatureTrend - empty response body, returning empty array');
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }

        const result = Array.isArray(data) ? data : [];
        span.setAttribute('response.count', result.length);
        span.setStatus({ code: SpanStatusCode.OK });

        console.info(`[ChartingAPI] getTemperatureTrend - received ${result.length} records`);
        return result;
      } catch (error) {
        console.error('[ChartingAPI] getTemperatureTrend - error:', error.message);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Fetch a flat list of raw temperature records for export.
   *
   * Maps to GET /api/charts/temperatures/export on sapphire-charting-api (T037).
   * Returns an empty array when the upstream responds with 204 No Content so
   * the resolver can always wrap it in { records: [] } without a null check.
   *
   * @param {string} userId        - User identifier (email / UUID).
   * @param {string} dateFrom      - ISO-8601 start of the export window.
   * @param {string} dateTo        - ISO-8601 end of the export window.
   * @param {string|null} deviceSource - Optional device source filter.
   * @returns {Promise<Array>} Flat array of Temperature record objects, possibly empty.
   */
  async getTemperatureExport(userId, dateFrom, dateTo, deviceSource) {
    return tracer.startActiveSpan('ChartingAPI.getTemperatureExport', async (span) => {
      try {
        span.setAttribute('user.id', userId);
        span.setAttribute('export.dateFrom', dateFrom);
        span.setAttribute('export.dateTo', dateTo);
        if (deviceSource) {
          span.setAttribute('export.deviceSource', deviceSource);
        }

        const params = new URLSearchParams({ userId, dateFrom, dateTo });
        if (deviceSource) {
          params.set('deviceSource', deviceSource);
        }

        console.info('[ChartingAPI] getTemperatureExport - fetching', {
          userId,
          dateFrom,
          dateTo,
          deviceSource: deviceSource || null,
        });

        let data;
        try {
          data = await this.get(`/api/charts/temperatures/export?${params.toString()}`);
        } catch (fetchErr) {
          // 204 No Content means no records in range — return empty array.
          if (fetchErr.extensions?.response?.status === 204) {
            console.info('[ChartingAPI] getTemperatureExport - 204 No Content, returning empty array');
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }
          throw fetchErr;
        }

        // Handle explicit null/undefined body (204 without throw)
        if (data == null) {
          console.info('[ChartingAPI] getTemperatureExport - empty response body, returning empty array');
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }

        const result = Array.isArray(data) ? data : [];
        span.setAttribute('response.count', result.length);
        span.setStatus({ code: SpanStatusCode.OK });

        console.info(`[ChartingAPI] getTemperatureExport - received ${result.length} records`);
        return result;
      } catch (error) {
        console.error('[ChartingAPI] getTemperatureExport - error:', error.message);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

// Made with Bob
