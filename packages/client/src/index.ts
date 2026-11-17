export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export {
  connectViaProtocol,
  connectViaWebSocket,
  connectViaHotSwapProtocol,
} from "./websocket.js";
export type { HotSwapConnection } from "./websocket.js";
export type {
  WebSocketConnectionCloseEvent,
  WebSocketHeartbeatOptions,
  WebSocketHeartbeatHandle,
} from "./websocket.js";
export { WEB_SOCKET_HEARTBEAT_DEFAULTS, withPageVisibility } from "./websocket.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
export type { MessagePortServiceConnection } from "./messageport.js";
