/**
 * Authentication barrel export.
 */
export {
  initiateDeviceAuth,
  pollForToken,
  refreshToken,
  storeTokenForUser,
  getValidTokenForUser,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
  extractEmailFromToken,
  extractSubFromToken,
} from './oidc.js';

export {
  initTokenStore,
  getUserToken,
  getUserTokenByEmail,
  setUserToken,
  deleteUserToken,
  getAllUserTokens,
} from './tokens.js';

export type { DeviceAuthResponse, TokenResponse } from './oidc.js';
export type { StoredToken, TokenInput } from './tokens.js';
