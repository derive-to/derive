// Types for weather-report.mjs, which is plain JS so a shell script can run it directly as a CLI.
export interface Reading {
  place: string
  temperature_c: number
  wind_kph: number
  condition: string
  observed_at: string
  source?: string
}

export declare const renderWeatherReport: (
  readings: Reading[],
  meta?: { server?: string; deployment?: string; run?: string },
) => string
