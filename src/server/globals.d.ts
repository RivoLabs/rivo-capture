declare function GetConvar(name: string, defaultValue: string): string;
declare function GetCurrentResourceName(): string;
declare function emitNet(eventName: string, target: string | number, ...args: any[]): void;
