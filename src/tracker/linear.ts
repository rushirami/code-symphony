import type { TrackerClient, TrackerConfig, TrackerIssue, BlockerRef } from "../types.js";
import type { Logger } from "pino";

const CANDIDATES_QUERY = `
query FetchCandidates($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $after: String) {
  projects(filter: { slugId: { eq: $projectSlug } }) {
    nodes {
      issues(
        filter: { state: { name: { in: $stateNames } } }
        first: $first
        after: $after
      ) {
        nodes {
          id
          identifier
          title
          description
          state { name }
          priority
          url
          labels { nodes { name } }
          branchName
          createdAt
          updatedAt
          relations {
            nodes {
              type
              relatedIssue {
                id
                identifier
                state { name }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const STATES_BY_IDS_QUERY = `
query FetchStatesByIds($ids: [ID!]!) {
  issues(filter: { id: { in: $ids } }) {
    nodes {
      id
      state { name }
    }
  }
}`;

const ISSUES_BY_STATES_QUERY = `
query FetchIssuesByStates($projectSlug: String!, $stateNames: [String!]!) {
  projects(filter: { slugId: { eq: $projectSlug } }) {
    nodes {
      issues(
        filter: { state: { name: { in: $stateNames } } }
        first: 250
      ) {
        nodes {
          id
          identifier
          title
          description
          state { name }
          priority
          url
          labels { nodes { name } }
          branchName
          createdAt
          updatedAt
          relations {
            nodes {
              type
              relatedIssue {
                id
                identifier
                state { name }
              }
            }
          }
        }
      }
    }
  }
}`;

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  priority: number | null;
  url: string;
  labels: { nodes: Array<{ name: string }> };
  branchName: string | null;
  createdAt: string;
  updatedAt: string;
  relations?: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
        state: { name: string };
      };
    }>;
  };
}

function normalizeIssue(raw: RawIssue): TrackerIssue {
  const blockedBy: BlockerRef[] = (raw.relations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: r.relatedIssue.id,
      identifier: r.relatedIssue.identifier,
      state: r.relatedIssue.state.name,
    }));

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    state: raw.state.name,
    priority: raw.priority,
    url: raw.url,
    labels: raw.labels.nodes.map((l) => l.name.toLowerCase()),
    branchName: raw.branchName,
    blockedBy,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

interface CandidatesResponse {
  projects: {
    nodes: Array<{
      issues: {
        nodes: RawIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>;
  };
}

interface StatesResponse {
  issues: { nodes: Array<{ id: string; state: { name: string } }> };
}

interface IssuesByStatesResponse {
  projects: {
    nodes: Array<{
      issues: { nodes: RawIssue[] };
    }>;
  };
}

export function createLinearClient(
  config: TrackerConfig,
  log: Logger,
): TrackerClient {
  async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Linear API ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL: ${json.errors[0].message}`);
    }

    return json.data!;
  }

  async function* fetchCandidates(): AsyncGenerator<
    TrackerIssue[],
    void,
    unknown
  > {
    let cursor: string | null = null;
    const pageSize = 50;

    do {
      const data: CandidatesResponse = await graphql<CandidatesResponse>(CANDIDATES_QUERY, {
        projectSlug: config.projectSlug,
        stateNames: config.activeStates,
        first: pageSize,
        after: cursor,
      });

      const project: CandidatesResponse["projects"]["nodes"][number] | undefined = data.projects.nodes[0];
      if (!project) {
        log.warn("No project found for slug: %s", config.projectSlug);
        return;
      }

      const page: typeof project.issues = project.issues;
      const issues = page.nodes.map(normalizeIssue);

      if (issues.length > 0) {
        yield issues;
      }

      cursor = page.pageInfo.hasNextPage
        ? page.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  async function fetchIssueStatesByIds(
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const data = await graphql<StatesResponse>(STATES_BY_IDS_QUERY, { ids });
    const map = new Map<string, string>();
    for (const node of data.issues.nodes) {
      map.set(node.id, node.state.name);
    }
    return map;
  }

  async function fetchIssuesByStates(
    states: string[],
  ): Promise<TrackerIssue[]> {
    if (states.length === 0) return [];

    const data = await graphql<IssuesByStatesResponse>(
      ISSUES_BY_STATES_QUERY,
      {
        projectSlug: config.projectSlug,
        stateNames: states,
      },
    );

    const project = data.projects.nodes[0];
    if (!project) return [];

    return project.issues.nodes.map(normalizeIssue);
  }

  return { fetchCandidates, fetchIssueStatesByIds, fetchIssuesByStates };
}
