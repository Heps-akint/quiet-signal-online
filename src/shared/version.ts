import packageMetadata from "../../package.json" with { type: "json" };

export const APP_VERSION = packageMetadata.version;
export const PROTOCOL_VERSION = 1 as const;
