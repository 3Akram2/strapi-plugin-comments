import { StrapiContext } from './@types';
import { setupGQL } from './graphql';
import permissions from './permissions';
import { getPluginService } from './utils/getPluginService';
import handleTagMentions from './utils/handleTagMentions';

export default async ({ strapi }: StrapiContext) => {
  if (strapi.plugin('graphql')) {
    await setupGQL({ strapi });
  }
  // Check if the plugin users-permissions is installed because the navigation needs it
  if (Object.keys(strapi.plugins).indexOf('users-permissions') === -1) {
    throw new Error(
      'In order to make the comments plugin work the users-permissions plugin is required',
    );
  }
  // Add permissions
  const actions = [
    {
      section: 'plugins',
      displayName: 'Comments: Read',
      uid: permissions.comments.read,
      pluginName: 'comments',
    },
    {
      section: 'plugins',
      displayName: 'Comments: Moderate',
      uid: permissions.comments.moderate,
      pluginName: 'comments',
    },
    {
      section: 'plugins',
      displayName: 'Reports: Read',
      uid: permissions.reports.read,
      pluginName: 'comments',
    },
    {
      section: 'plugins',
      displayName: 'Reports: Moderate',
      uid: permissions.reports.review,
      pluginName: 'comments',
    },
    {
      section: 'plugins',
      displayName: 'Settings: Read',
      uid: permissions.settings.read,
      pluginName: 'comments',
    },
    {
      section: 'plugins',
      displayName: 'Settings: Change',
      uid: permissions.settings.change,
      pluginName: 'comments',
    },
  ];

  await strapi.admin.services.permission.actionProvider.registerMany(actions);

  const commonService = getPluginService(strapi, 'common');
  strapi.db.lifecycles.subscribe({
    afterDelete: async (event) => {
      const uid = event.model.uid;
      const { documentId, locale } = event.result;
      const relation = [uid, documentId].join(':');
      await commonService.perRemove(relation, locale);
    },
    afterCreate: async (event) => {
      const uid = event.model.uid;
      const { documentId, locale } = event.result;
      const relation = [uid, documentId].join(':');
      await commonService.perRestore(relation, locale);
    }
  });

  // Maintain commentsCount on the related content type.
  // Port of the old andrew-api extension hooks (handle-comments-count +
  // handle-comments-counts-on-update) so consumers don't need a strapi-server.js
  // extension to track counts on posts etc.
  const extractRelated = (related: string | undefined | null) => {
    if (!related) return null;
    const match = related.match(/^(api::[a-z0-9-]+\.[a-z0-9-]+):(\d+)$/);
    if (!match) return null;
    return { uid: match[1], id: parseInt(match[2], 10) };
  };

  const adjustCommentsCount = async (related: string, delta: 1 | -1) => {
    const parsed = extractRelated(related);
    if (!parsed) return;
    try {
      const record: any = await (strapi.db.query as any)(parsed.uid).findOne({
        where: { id: parsed.id },
        select: ['commentsCount'],
      });
      if (!record || record.commentsCount === undefined) return;
      const current = record.commentsCount ?? 0;
      const next = Math.max(0, current + delta);
      await (strapi.db.query as any)(parsed.uid).update({
        where: { id: parsed.id },
        data: { commentsCount: next },
      });
    } catch (e: any) {
      strapi.log.warn(
        `[comments] commentsCount update failed on ${related}: ${e?.message}`
      );
    }
  };

  strapi.db.lifecycles.subscribe({
    models: ['plugin::comments.comment'],

    // Parse `@andrewUser` / `#hashtag` tokens out of content and attach the
    // resolved relations (andrew-api-specific behaviour carried over from the
    // old @swensonhe fork).
    async beforeCreate(event) {
      await handleTagMentions(strapi, event.params?.data);
    },

    async afterCreate(event) {
      if (process.env.NODE_ENV === 'test') return;
      const result: any = event.result;
      if (!result?.related) return;
      await adjustCommentsCount(result.related, 1);
    },

    async beforeUpdate(event) {
      // Re-parse content when it changes so mentions/tags stay in sync.
      if (event.params?.data?.content != null) {
        await handleTagMentions(strapi, event.params.data);
      }

      const data: any = event.params?.data;
      const where: any = event.params?.where;
      if (!where?.id) return;
      const current: any = await strapi.db
        .query('plugin::comments.comment')
        .findOne({
          where: { id: where.id },
          select: ['blocked', 'removed', 'related'],
        });
      if (!current?.related) return;

      // Decrement when becoming hidden (blocked false→true OR removed null→true)
      const becomingBlocked =
        current.blocked === false && data?.blocked === true;
      const becomingRemoved =
        current.removed == null && data?.removed === true;
      if (becomingBlocked || becomingRemoved) {
        await adjustCommentsCount(current.related, -1);
        return;
      }

      // Increment when becoming visible again (blocked true→false)
      const becomingUnblocked =
        current.blocked === true && data?.blocked === false;
      if (becomingUnblocked) {
        await adjustCommentsCount(current.related, 1);
      }
    },
  });
};
