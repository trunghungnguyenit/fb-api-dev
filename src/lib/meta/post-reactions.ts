// Reactions of ONE post by kind, read straight from the post (GET /{post-id}?fields=reactions.type(X)...). Pure module: which
// kinds exist, the fields to ask for, and how the answer becomes numbers. It works for videos and Reels too and is as fresh as
// the post itself.

/** The kinds of reaction, in the order they are shown, with their Vietnamese names. */
const REACTION_LABELS: Record<string, string> = {
  like: "Thích", love: "Yêu thích", care: "Thương thương", haha: "Haha", wow: "Wow", sorry: "Buồn", anger: "Phẫn nộ"
};

export type ReactionKey = "like" | "love" | "care" | "haha" | "wow" | "sorry" | "anger";

/** `graph` = the kind's name in the Graph API's `type(...)`. Keys are the names under which each kind is asked for. */
export const REACTION_TYPES: readonly { key: ReactionKey; graph: string; label: string }[] = [
  { key: "like", graph: "LIKE" }, { key: "love", graph: "LOVE" }, { key: "care", graph: "CARE" }, { key: "haha", graph: "HAHA" },
  { key: "wow", graph: "WOW" }, { key: "sorry", graph: "SAD" }, { key: "anger", graph: "ANGRY" }
].map((t) => ({ ...t, key: t.key as ReactionKey, label: REACTION_LABELS[t.key] }));

const TOTAL_ALIAS = "total";
const field = (type: string | null, alias: string) => `reactions${type ? `.type(${type})` : ""}.limit(0).summary(total_count).as(${alias})`;

/** The `fields` for all of the given kinds in one request (aliased, so every answer can be told apart), and the total. */
export const reactionFields = (types: readonly { key: string; graph: string }[], withTotal = true) =>
  [...(withTotal ? [field(null, TOTAL_ALIAS)] : []), ...types.map((t) => field(t.graph, t.key))].join(",");

export type ReactionsView = {
  /** All reactions of the post; null when Facebook did not give it. */
  total: number | null;
  /** In Facebook's usual order. `value` is null for a kind Facebook did not answer. */
  types: { key: ReactionKey; label: string; value: number | null }[];
};

const countOf = (body: unknown, alias: string): number | null => {
  const n = (body as Record<string, { summary?: { total_count?: unknown } } | undefined> | null)?.[alias]?.summary?.total_count;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** Facebook's body -> numbers by kind. Anything it did not give stays null; nothing is guessed. */
export function parseReactions(body: unknown): ReactionsView {
  return {
    total: countOf(body, TOTAL_ALIAS),
    types: REACTION_TYPES.map((t) => ({ key: t.key, label: t.label, value: countOf(body, t.key) }))
  };
}
