/**
 * lib/tr-api.js — thin client for the Text Request v3 REST API.
 *
 * Replaces the browser-scraping path: the API is authenticated with a static
 * `x-api-key` header (no login, no SMS MFA, no Playwright session to expire).
 *
 * Docs: https://www.textrequest.com/api/v3  (OpenAPI: /dist/swagger/apiv3docs.yml)
 * Base: https://api.textrequest.com/api/v3
 */
const fs = require('fs');

const BASE_URL = 'https://api.textrequest.com/api/v3';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

class TextRequestApi {
  constructor(apiKey, { baseUrl = BASE_URL } = {}) {
    if (!apiKey) throw new Error('Text Request API key is required (set TR_API_KEY in .env).');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /** GET a path (relative to baseUrl). Returns parsed JSON, or null for 204. */
  async get(path, query) {
    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const res = await fetch(url, { headers: { 'x-api-key': this.apiKey, Accept: 'application/json' } });
    if (res.status === 204) return null; // documented "no results" for several collections
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, 300);
      const err = new Error(`Text Request API ${res.status} ${res.statusText} on GET ${path}${qs} — ${snippet}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  /**
   * Fetch every page of a paginated collection endpoint and return the flat
   * `items` array. Stops when fewer than page_size items come back or the
   * reported total is reached.
   */
  async getAll(path, query = {}, pageSize = 100) {
    const items = [];
    let page = 0;
    for (;;) {
      const data = await this.get(path, { ...query, page, page_size: pageSize });
      if (!data || !Array.isArray(data.items) || data.items.length === 0) break;
      items.push(...data.items);
      const total = data.meta?.total_items;
      if (data.items.length < pageSize) break;
      if (typeof total === 'number' && items.length >= total) break;
      page++;
      if (page > 1000) break; // runaway guard
    }
    return items;
  }

  /** All dashboards in the account. Response items: { id, name, phone }. */
  listDashboards() {
    return this.getAll('/dashboards');
  }

  /**
   * Conversations for a dashboard (one per contact), each with its
   * `last_message`. `unresolvedOnly` / `includeArchived` map to the
   * server-side filters.
   */
  listConversations(dashboardId, { unresolvedOnly = true, includeArchived = false } = {}) {
    return this.getAll(`/dashboards/${dashboardId}/conversations`, {
      show_unresolved_only: unresolvedOnly,
      include_archived: includeArchived,
    });
  }

  /** A single contact (display_name, first/last, is_resolved, is_archived, thread_id). */
  getContact(dashboardId, phone) {
    return this.get(`/dashboards/${dashboardId}/contacts/${encodeURIComponent(phone)}`);
  }

  /**
   * The most recent `limit` messages in a contact's thread, returned in
   * chronological order (oldest → newest). The API returns newest-first, so we
   * fetch one page of `limit` and reverse.
   */
  async getRecentMessages(dashboardId, phone, limit = 15) {
    const data = await this.get(
      `/dashboards/${dashboardId}/contacts/${encodeURIComponent(phone)}/messages`,
      { page: 0, page_size: limit },
    );
    const items = (data && data.items) || [];
    return items.slice().reverse();
  }
}

module.exports = { TextRequestApi, readEnv, BASE_URL };
