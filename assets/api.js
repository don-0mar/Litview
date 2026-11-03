/* Litview API client.
 * The API address comes from <meta name="litview-api">. When it's empty, Litview runs
 * entirely in the browser (no accounts, no saving, no AI), exactly as before. */
(() => {
  "use strict";
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const base = (store.get("litview.api") || document.querySelector('meta[name="litview-api"]')?.content || "").replace(/\/+$/, "");

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  const Api = {
    enabled: !!base,
    base,
    token: store.get("litview.token"),
    user: JSON.parse(store.get("litview.user") || "null"),
    capabilities: null, // filled by loadCapabilities(): { open, keyed: {scopus, ieee, springer}, ai }

    get signedIn() { return !!(this.token && this.user); },

    async req(method, path, body) {
      if (!this.enabled) throw new ApiError(0, "Accounts aren't available on this copy of Litview.");
      const headers = { "Content-Type": "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      let r;
      try {
        r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch {
        throw new ApiError(0, "Couldn't reach the Litview server. It may be waking up; try again in a minute.");
      }
      if (r.status === 204) return null;
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 && this.token && !path.startsWith("/api/auth/login")) this.setSession(null);
      if (!r.ok) throw new ApiError(r.status, data.error || `The server answered with HTTP ${r.status}.`);
      return data;
    },

    setSession(s) {
      this.token = s?.token || null;
      this.user = s?.user || null;
      store.set("litview.token", this.token);
      store.set("litview.user", this.user ? JSON.stringify(this.user) : null);
      document.dispatchEvent(new CustomEvent("litview:session"));
    },

    async loadCapabilities() {
      if (!this.enabled) return null;
      try { this.capabilities = await this.req("GET", "/api/sources"); } catch { this.capabilities = null; }
      return this.capabilities;
    },

    // accounts
    async register(name, email, password) { this.setSession(await this.req("POST", "/api/auth/register", { name, email, password })); },
    async login(email, password) { this.setSession(await this.req("POST", "/api/auth/login", { email, password })); },
    signOut() { this.setSession(null); },
    async checkSession() {
      if (!this.token) return;
      try { const { user } = await this.req("GET", "/api/auth/me"); this.user = user; store.set("litview.user", JSON.stringify(user)); }
      catch (e) { if (e.status === 401) this.setSession(null); }
    },

    // search
    search: (db, opts) => Api.req("POST", `/api/search/${db}`, opts),
    enrich: dois => Api.req("POST", "/api/enrich", { dois }),

    // reviews
    listReviews: () => Api.req("GET", "/api/reviews"),
    createReview: body => Api.req("POST", "/api/reviews", body),
    getReview: id => Api.req("GET", `/api/reviews/${id}`),
    updateReview: (id, body) => Api.req("PATCH", `/api/reviews/${id}`, body),
    deleteReview: id => Api.req("DELETE", `/api/reviews/${id}`),
    putSource: (id, source, body) => Api.req("PUT", `/api/reviews/${id}/sources/${source}`, body),
    screening: id => Api.req("GET", `/api/reviews/${id}/screening`),
    putDecisions: (id, decisions) => Api.req("PUT", `/api/reviews/${id}/decisions`, { decisions }),
    resolve: (id, d) => Api.req("PUT", `/api/reviews/${id}/resolutions`, d),
    invite: id => Api.req("POST", `/api/reviews/${id}/invite`),
    join: code => Api.req("POST", "/api/reviews/join", { code }),
    removeMember: (id, userId) => Api.req("DELETE", `/api/reviews/${id}/members/${userId}`),
    synthesise: (id, keys, rqs) => Api.req("POST", `/api/reviews/${id}/synthesis`, { keys, rqs }),
    clearSynthesis: id => Api.req("DELETE", `/api/reviews/${id}/synthesis`),
  };

  window.LitviewApi = Api;
})();
