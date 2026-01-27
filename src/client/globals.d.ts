declare function RegisterNuiCallbackType(type: string): void;
declare function GetConvar(name: string, defaultValue: string): string;
declare function GetCurrentResourceName(): string;
declare function SendNuiMessage(message: string): void;
declare function GetCurrentServerEndpoint(): string;
declare function on(eventName: string, handler: (...args: any[]) => void): void;
declare function onNet(eventName: string, handler: (...args: any[]) => void): void;
