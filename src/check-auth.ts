// Makes one read-only call to check that the service can authenticate with Namespace.
import { getTenantId } from "@namespacelabs/sdk/auth";
import { compute, credential, tokenSource } from "./namespace.ts";

const token = await tokenSource.issueToken(60_000);
const { instances } = await compute.compute.listInstances({});

console.log(`Credential: ${credential}`);
console.log(`Workspace (tenant): ${getTenantId(token)}`);
console.log(`Running instances: ${instances.length}`);
