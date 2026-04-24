/**
 * Andrew-specific comment content parser.
 *
 * Port of the old @swensonhe/strapi-plugin-comments handleTagMentions util:
 *   - `@andrewUser` tokens in comment content resolve to
 *     plugin::users-permissions.user rows (matched on the custom `andrewUser`
 *     column) and end up on the comment's `mentions` relation.
 *   - `#hashtag` tokens resolve-or-create api::tag.tag rows and end up on the
 *     comment's `tags` relation.
 *
 * This is intentionally self-contained (not calling host-app services) so the
 * plugin's lifecycle does not depend on andrew-api services being loaded.
 * The regexes, SQL lookups, and field names match the original plugin byte-for-byte.
 */

type AnyStrapi = any;

export const extractHashtags = (content: string): string[] => {
  const regex = /(?<=#)\w+/g;
  const matches = content.match(regex);
  if (!matches) return [];
  return [...new Set(matches)];
};

export const extractMentions = (content: string): string[] => {
  const regex = /(?<=@)\w+/g;
  const matches = content.match(regex);
  if (!matches) return [];
  return [...new Set(matches)];
};

export const findOrCreateOneTag = async (strapi: AnyStrapi, tag: string) => {
  const existing = await strapi.db.query('api::tag.tag').findOne({
    where: { value: { $eq: tag } },
  });
  if (existing) return existing;
  return strapi.db.query('api::tag.tag').create({
    data: { value: tag },
  });
};

export const findOrCreateManyTags = async (strapi: AnyStrapi, tags: string[]) => {
  return Promise.all(tags.map((t) => findOrCreateOneTag(strapi, t)));
};

export const findMention = async (strapi: AnyStrapi, mention: string) => {
  return strapi.db.query('plugin::users-permissions.user').findOne({
    where: { andrewUser: { $eq: mention } },
  });
};

export const findMentions = async (strapi: AnyStrapi, mentions: string[]) => {
  if (!mentions.length) return [];
  return strapi.db.query('plugin::users-permissions.user').findMany({
    where: { andrewUser: { $in: mentions } },
  });
};

/**
 * Mutates `data` in place — attaches `data.mentions` and `data.tags` as arrays
 * of IDs derived from the `@`/`#` tokens in `data.content`. No-op when
 * `data.content` is absent. Safe to call repeatedly on the same data object.
 */
export default async function handleTagMentions(
  strapi: AnyStrapi,
  data: { content?: string; mentions?: any; tags?: any; [k: string]: any }
) {
  if (!data || typeof data.content !== 'string' || data.content.length === 0) {
    return data;
  }

  const mentionTokens = extractMentions(data.content);
  const users = await findMentions(strapi, mentionTokens);

  const hashtagTokens = extractHashtags(data.content);
  const tags = hashtagTokens.length
    ? await findOrCreateManyTags(strapi, hashtagTokens)
    : [];

  data.mentions = users.map((u: any) => u.id);
  data.tags = tags.map((t: any) => t.id);
  return data;
}
