import type { IssuesRead } from "../log.js";

/**
 * Where an MCP client reads an issue: `issues://issue/17` when numbered (the bare number, since a
 * `?` would start the URI's query), else `issues://issue/<id>`. The `refer` of every MCP header.
 */
export function issueUri(read: IssuesRead): (id: string) => string {
  return (id) => {
    const n = read.projection.views.get(id)?.number ?? null;
    return `issues://issue/${n === null ? id : n}`;
  };
}
