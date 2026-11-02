import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { fromBearerToken, loadDefaults } from "@namespacelabs/sdk/auth";

// NAMESPACE_TOKEN, such as one from `nsc auth generate-dev-token`, works on any machine. Without it,
// the SDK uses this machine's `nsc login` and renews its tokens automatically.
export const credential = process.env.NAMESPACE_TOKEN ? "NAMESPACE_TOKEN" : "nsc login";

export const tokenSource = process.env.NAMESPACE_TOKEN
  ? fromBearerToken(process.env.NAMESPACE_TOKEN)
  : await loadDefaults();

export const compute = createComputeClient({ tokenSource });
