// The customer's choices for their repository, read from .pr-previews.yml at the pull request's
// commit. A flat "key: value" file:
//
//   runtime: instance        # or devbox
//   port: 3000               # the HTTP port the app listens on
//   dockerfile: Dockerfile   # instance: what the remote builder builds
//   build: npm ci && npm run build   # devbox: run in the checkout on every push
//   start: npm start                 # devbox: runs as a service, with PORT set
export interface PreviewConfig {
  runtime: "instance" | "devbox";
  port: number;
  dockerfile: string;
  build?: string;
  start?: string;
}

export const configPath = ".pr-previews.yml";

export function parseConfig(text: string): PreviewConfig {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.replace(/\s+#.*$/, "").match(/^([a-z]+):\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (values.runtime !== "instance" && values.runtime !== "devbox") {
    throw new Error(`${configPath}: runtime must be "instance" or "devbox"`);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${configPath}: port must be a number`);
  if (values.dockerfile?.split("/").includes("..")) throw new Error(`${configPath}: dockerfile must be inside the repository`);
  if (values.runtime === "devbox" && !values.start) throw new Error(`${configPath}: the devbox runtime needs start`);
  return { runtime: values.runtime, port, dockerfile: values.dockerfile || "Dockerfile", build: values.build, start: values.start };
}
