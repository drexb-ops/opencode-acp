import type { Plugin as V2Api } from "@opencode/plugin"

/**
 * V2 setup boundary. Registrations are intentionally deferred to later
 * migration phases; loading the package must not advertise incomplete APIs.
 */
export const setup: V2Api.Plugin["setup"] = async (_context) => {}
