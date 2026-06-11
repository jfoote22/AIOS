// "Fuel" layer: pull real GitHub repos/tools matched to the brain's top topics,
// so the loop also gathers external tech to help build/maintain knowledge.
// Uses GitHub's public search API (unauthenticated; rate-limited but fine for a
// few queries) directly from the renderer.

export interface Repo {
  id: number;
  fullName: string;
  description: string;
  stars: number;
  url: string;
  language: string;
  topics: string[];
}

export async function searchRepos(topic: string, perPage = 6): Promise<Repo[]> {
  const q = topic.trim();
  if (!q) return [];
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(q) +
    `&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("GitHub rate limit reached — try again in a minute.");
    }
    throw new Error(`GitHub search failed (${res.status})`);
  }
  const data = await res.json();
  return (data.items ?? []).map(
    (r: any): Repo => ({
      id: r.id,
      fullName: r.full_name,
      description: r.description || "",
      stars: r.stargazers_count || 0,
      url: r.html_url,
      language: r.language || "",
      topics: Array.isArray(r.topics) ? r.topics.slice(0, 4) : [],
    }),
  );
}
