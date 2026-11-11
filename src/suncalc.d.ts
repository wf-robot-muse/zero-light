declare module "suncalc" {
  export interface SunTimes {
    sunrise: Date;
    sunset: Date;
    dawn: Date;
    dusk: Date;
    solarNoon: Date;
    nightEnd: Date;
    night: Date;
    [key: string]: Date;
  }
  export interface MoonTimes {
    rise?: Date;
    set?: Date;
    alwaysUp?: boolean;
    alwaysDown?: boolean;
  }
  export interface MoonIllumination {
    fraction: number;
    phase: number;
    angle: number;
    waxing?: boolean;
  }
  export interface MoonPosition {
    azimuth: number;
    altitude: number;
    distance: number;
    parallacticAngle: number;
  }
  export function getTimes(date: Date, lat: number, lng: number): SunTimes;
  export function getMoonTimes(date: Date, lat: number, lng: number, inUTC?: boolean): MoonTimes;
  export function getMoonIllumination(date: Date): MoonIllumination;
  export function getMoonPosition(date: Date, lat: number, lng: number): MoonPosition;
  export function getPosition(date: Date, lat: number, lng: number): { azimuth: number; altitude: number };
}
