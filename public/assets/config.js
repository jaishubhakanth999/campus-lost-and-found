/* Runtime configuration for the browser.
 *
 * Split deployment: the pages live on Vercel, the API on Render. apiBase is the
 * API origin, and it must also be listed in CORS_ORIGINS on the server.
 * Leave it empty only when the same Express server serves these pages.
 */
window.CAMPUS_CONFIG = {
  apiBase: 'https://campus-lost-and-found2.onrender.com',
  siteName: 'CampusConnect',
  university: 'Sai University',
};
