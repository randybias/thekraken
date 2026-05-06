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
  getRefreshLoopStatus,
} from './oidc.js';

export {
  initTokenStore,
  getUserToken,
  setUserToken,
  deleteUserToken,
  getAllUserTokens,
} from './tokens.js';

export type { DeviceAuthResponse, TokenResponse, RefreshLoopStatus } from './oidc.js';
export type { StoredToken, TokenInput } from './tokens.js';
