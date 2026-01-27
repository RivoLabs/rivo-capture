// FiveM Server Globals
declare function GetConvar(name: string, defaultValue: string): string;
declare function GetCurrentResourceName(): string;

// Event functions
declare function on(eventName: string, handler: (...args: any[]) => void): void;
declare function onNet(eventName: string, handler: (...args: any[]) => void): void;
declare function emit(eventName: string, ...args: any[]): void;
declare function emitNet(eventName: string, target: string | number, ...args: any[]): void;

// Player source (set by FiveM in event handlers)
declare const source: number;
