/** Application configuration resolved from environment variables. */
export interface AppConfig {
  port: number;
  jwtExpirationSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    jwtExpirationSeconds: Number(env.JWT_EXPIRATION_SECONDS ?? 3600),
    logLevel: (env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
  };
}
