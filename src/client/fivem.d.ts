// FiveM Client Globals
declare function RegisterNuiCallbackType(name: string): void;
declare function SendNuiMessage(message: string): void;
declare function GetCurrentResourceName(): string;
declare function GetCurrentServerEndpoint(): string;

// Event functions
declare function on(eventName: string, handler: (...args: any[]) => void): void;
declare function onNet(eventName: string, handler: (...args: any[]) => void): void;
declare function emit(eventName: string, ...args: any[]): void;
declare function emitNet(eventName: string, ...args: any[]): void;
