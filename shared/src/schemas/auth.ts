import { z } from "zod";
import { User } from "./user.js";

// Response for POST /v1/auth/sso/cloudflare (SWY-161). The plaintext token is
// returned exactly once, same as token creation; the client stores it like a
// pasted token.
export const SsoLoginResponse = z.object({
  token: z.string(),
  user: User,
});
export type SsoLoginResponse = z.infer<typeof SsoLoginResponse>;
