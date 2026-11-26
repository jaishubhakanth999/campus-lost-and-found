/* Runtime configuration for the browser.
 *
 * Same-origin deployment (Express serves this folder): leave apiBase empty.
 * Split deployment (frontend on Vercel, API on Render): set apiBase to the API
 * origin, e.g. "https://campusconnect-api.onrender.com", and add that origin to
 * CORS_ORIGINS on the server.
 */
window.CAMPUS_CONFIG = {
  apiBase: '',
  siteName: 'CampusConnect',
  university: 'Sai University',
};
