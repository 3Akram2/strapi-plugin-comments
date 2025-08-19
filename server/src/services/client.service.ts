import { isEmpty } from 'lodash';
import { AdminUser, StrapiContext } from '../@types';
import { APPROVAL_STATUS, CONFIG_PARAMS } from '../const';
import { getCommentRepository, getReportCommentRepository } from '../repositories';
import { isLeft, unwrapEither } from '../utils/Either';
import PluginError from '../utils/error';
import { getPluginService } from '../utils/getPluginService';
import { tryCatch } from '../utils/tryCatch';
import { client } from '../validators/api';
import { Comment } from '../validators/repositories';
import { resolveUserContextError } from './utils/functions';

/**
 * Comments Plugin - Client services
 */

export const clientService = ({ strapi }: StrapiContext) => {
  const createAuthor = async (
    author: client.NewCommentValidatorSchema['author'],
    user?: AdminUser
  ) => {
    if (user) {
      // Try to fetch user data using Document Service API first (Strapi v5), fallback to query API
      let dbUser;
      try {
        if (user.documentId) {
          dbUser = await strapi.documents('plugin::users-permissions.user').findOne({
            documentId: user.documentId,
            populate: ['image'],
          });
        } else {
          // Fallback to query API if no documentId
          dbUser = await strapi
            .query('plugin::users-permissions.user')
            .findOne({
              where: { id: user.id },
              populate: ['image'],
            });
        }
      } catch (error) {
        // Fallback to query API on error
        dbUser = await strapi
          .query('plugin::users-permissions.user')
          .findOne({
            where: { id: user.id },
            populate: ['image'],
          });
      }
      
      return {
        authorId: user.id,
        authorDocumentId: user.documentId || dbUser?.documentId || null,
        authorName: `${dbUser?.firstName || ''} ${dbUser?.lastName || ''}`.trim() || user.username,
        authorUsername: user.username,
        authorEmail: user.email,
        authorAvatar: dbUser?.image?.url || null,
      };
    } else if (author) {
      return {
        authorId: author.id,
        authorDocumentId: author.documentId || null,
        authorName: author.name,
        authorUsername: (author as any).username || author.name,
        authorEmail: author.email,
        authorAvatar: author.avatar,
      };
    }
  };
  return ({
    getCommonService() {
      return getPluginService(strapi, 'common');
    },

    // Create a comment
    async create({ relation, content, threadOf, author, approvalStatus, locale }: client.NewCommentValidatorSchema, user?: AdminUser) {
      const { uid, relatedId } = this.getCommonService().parseRelationString(relation);
      const relatedEntity = await strapi.documents(uid).findOne({ documentId: relatedId, locale });
      if (!relatedEntity) {
        throw new PluginError(
          400,
          `Relation for field "related" does not exist. Check your payload please.`,
        );
      }
      const approvalFlow = await this.getCommonService().getConfig(CONFIG_PARAMS.APPROVAL_FLOW, []);
      const isApprovalFlowEnabled = approvalFlow.includes(uid) || relatedEntity.requireCommentsApproval;
      const doNotPopulateAuthor = await this.getCommonService().getConfig(
        CONFIG_PARAMS.AUTHOR_BLOCKED_PROPS,
        [],
      );
      const threadData = await tryCatch(
        async () => {
          if (!threadOf) return null;
          
          // Check if threadOf is a documentId (string format) or numeric ID
          const isDocumentId = typeof threadOf === 'string' && isNaN(Number(threadOf));
          
          if (isDocumentId) {
            // First, find the comment by documentId to get its numeric ID
            const threadComment = await getCommentRepository(strapi).findOne({
              where: { documentId: threadOf },
              populate: { authorUser: true },
            });
            
            if (!threadComment) {
              throw new PluginError(400, 'Thread comment with provided documentId does not exist');
            }
            
            // Use the numeric ID from the found comment
            return await this.getCommonService().findOne({ id: threadComment.id, related: relation, locale: locale || null });
          } else {
            // Original logic for numeric ID
            return await this.getCommonService().findOne({ id: threadOf, related: relation, locale: locale || null });
          }
        },
        new PluginError(400, 'Thread does not exist'),
      );
      if (isLeft(threadData)) {
        throw unwrapEither(threadData);
      }
      const linkToThread = unwrapEither(threadData);
      if (!author && !this.getCommonService().isValidUserContext(user)) {
        throw resolveUserContextError(user);
      }
      const [clearContent, authorData] = await Promise.all([
        this.getCommonService().checkBadWords(content),
        createAuthor(author, user),
      ]);
      const authorNotProperlyProvided = !isEmpty(authorData) && !(authorData.authorId);
      if (isEmpty(authorData) || authorNotProperlyProvided) {
        throw new PluginError(400, 'Not able to recognise author of a comment. Make sure you\'ve provided "author" property in a payload or authenticated your request properly.');
      }
      if (isApprovalFlowEnabled && approvalStatus && approvalStatus !== APPROVAL_STATUS.PENDING) {
        throw new PluginError(400, 'Invalid approval status');
      }

      const comment = await getCommentRepository(strapi).create({
        data: {
          ...authorData,
          threadOf: linkToThread ? linkToThread.id : null,
          locale,
          content: clearContent,
          related: relation,
          approvalStatus: isApprovalFlowEnabled
            ? APPROVAL_STATUS.PENDING
            : APPROVAL_STATUS.APPROVED,
        },
      });
      const entity: Comment = {
        ...comment,
        threadOf: linkToThread,
      };
      const sanitizedEntity = this.getCommonService().sanitizeCommentEntity(entity, doNotPopulateAuthor);

      try {
        await this.sendResponseNotification(sanitizedEntity);
      } catch (e) {
        console.error(e);
      }
      return sanitizedEntity;
    },

    // Update a comment
    async update({ commentId, commentDocumentId, content, author, relation }: client.UpdateCommentValidatorSchema, user?: AdminUser) {
      if (!author && !this.getCommonService().isValidUserContext(user)) {
        throw resolveUserContextError(user);
      }
      const authorId = user?.id || author?.id;
      if (await this.getCommonService().checkBadWords(content)) {
        const blockedAuthorProps = await this.getCommonService().getConfig(CONFIG_PARAMS.AUTHOR_BLOCKED_PROPS, []);
        
        // Build the find criteria - support both ID types
        const findCriteria: any = { related: relation };
        if (commentId) {
          // Try to determine if it's numeric or documentId
          const isNumericId = !isNaN(Number(commentId)) && isFinite(Number(commentId));
          if (isNumericId) {
            findCriteria.id = commentId;
          } else {
            findCriteria.documentId = commentId;
          }
        } else if (commentDocumentId) {
          findCriteria.documentId = commentDocumentId;
        }

        const existingComment = await this.getCommonService().findOne(findCriteria);

        if (existingComment && existingComment.author?.id?.toString() === authorId?.toString()) {
          let entity;
          
          // Update using appropriate method
          if (existingComment.documentId) {
            // Use Document Service API for updates when we have documentId
            entity = await strapi.documents('plugin::comments.comment').update({
              documentId: existingComment.documentId,
              data: { content } as any,
              populate: { threadOf: true, authorUser: true },
            });
          } else {
            // Use repository for ID-based updates
            entity = await getCommentRepository(strapi).update({
              where: { id: existingComment.id },
              data: { content },
              populate: { threadOf: true, authorUser: true },
            });
          }
          
          return this.getCommonService().sanitizeCommentEntity(entity, blockedAuthorProps);
        }
      }
    },

    // Report abuse in comment
    async reportAbuse({ commentId, relation, ...payload }: client.ReportAbuseValidatorSchema, user?: AdminUser) {
      if (!this.getCommonService().isValidUserContext(user)) {
        throw resolveUserContextError(user);
      }

      try {
        const reportAgainstEntity = await this.getCommonService().findOne({
          id: commentId,
          related: relation,
        });

        if (reportAgainstEntity.isAdminComment) {
          throw new PluginError(
            403,
            `You're not allowed to take an action on that entity. This in a admin comment.`,
          );
        }

        if (reportAgainstEntity) {
          const entity = await getReportCommentRepository(strapi)
          .create({
            data: {
              ...payload,
              resolved: false,
              related: commentId,
            },
          });
          if (entity) {
            const response = {
              ...entity,
              related: reportAgainstEntity,
            };
            try {
              await this.sendAbuseReportEmail(entity.reason, entity.content); // Could also add some info about relation
              return response;
            } catch (err) {
              return response;
            }
          } else {
            throw new PluginError(500, 'Report cannot be created');
          }
        }
        throw new PluginError(
          403,
          `You're not allowed to take an action on that entity. Make sure that comment exist or you've authenticated your request properly.`,
        );
      } catch (e) {
        throw e;
      }
    },

    async markAsRemoved({ commentId, commentDocumentId, relation, authorId, authorDocumentId }: client.RemoveCommentValidatorSchema, user: AdminUser) {
      if (!authorId && !authorDocumentId && !this.getCommonService().isValidUserContext(user)) {
        throw resolveUserContextError(user);
      }

      const author = user?.id || authorId;
      const authorDocId = user?.documentId || authorDocumentId;

      if (!author && !authorDocId) {
        throw new PluginError(
          403,
          `You're not allowed to take an action on that entity. Make sure that you've provided proper "authorId", "authorDocumentId" or authenticated your request properly.`,
        );
      }

      try {
        // First, find the comment by ID/documentId and relation
        const commentFilter: any = { related: relation };
        if (commentId) {
          // Try to find by ID first, if it's numeric, otherwise try by documentId
          const isNumericId = !isNaN(Number(commentId)) && isFinite(Number(commentId));
          if (isNumericId) {
            commentFilter.id = commentId;
          } else {
            commentFilter.documentId = commentId;
          }
        } else if (commentDocumentId) {
          commentFilter.documentId = commentDocumentId;
        }

        let entity;
        try {
          entity = await this.getCommonService().findOne(commentFilter);
        } catch (error) {
          // If initial search fails and we tried by ID with a string, try by documentId
          if (commentId && typeof commentId === 'string' && !commentDocumentId) {
            try {
              entity = await this.getCommonService().findOne({
                related: relation,
                documentId: commentId
              });
            } catch (secondError) {
              throw error; // Throw the original error
            }
          } else {
            throw error;
          }
        }
        
        // Then verify ownership
        if (entity) {
          const isOwner = user?.id 
            ? entity.author?.id?.toString() === user.id.toString()
            : authorDocId 
              ? entity.author?.documentId === authorDocId
              : entity.author?.id?.toString() === author?.toString();
          
          if (!isOwner) {
            throw new PluginError(
              403,
              `You're not allowed to delete this comment. You can only delete your own comments.`,
            );
          }
        }
        if (entity) {
          // Update the comment using the entity we found
          let removedEntity;
          if (entity.documentId) {
            // Use Document Service API for updates when we have documentId
            removedEntity = await strapi.documents('plugin::comments.comment').update({
              documentId: entity.documentId,
              data: { removed: true } as any,
              populate: { threadOf: true, authorUser: true },
            });
          } else {
            // Use repository for ID-based updates
            const updateWhere: any = { related: relation };
            if (commentId) {
              updateWhere.id = commentId;
            } else if (commentDocumentId) {
              updateWhere.documentId = commentDocumentId;
            } else {
              updateWhere.id = entity.id;
            }

            removedEntity = await getCommentRepository(strapi)
            .update({
              where: updateWhere,
              data: { removed: true },
              populate: { threadOf: true, authorUser: true },
            });
          }

          // Use the entity's ID for nested removal (always use numeric ID for this)
          await this.markAsRemovedNested(entity.id, true);
          const doNotPopulateAuthor = await this.getCommonService().getConfig(CONFIG_PARAMS.AUTHOR_BLOCKED_PROPS, []);

          return this.getCommonService().sanitizeCommentEntity(removedEntity, doNotPopulateAuthor);
        } else {
          throw new PluginError(
            404,
            `Entity does not exist or you're not allowed to take an action on it`,
          );
        }
      } catch (e) {
        throw new PluginError(
          404,
          `Entity does not exist or you're not allowed to take an action on it`,
        );
      }
    },

    async sendAbuseReportEmail(reason: string, content: string) {
      const SUPER_ADMIN_ROLE = 'strapi-super-admin';
      const rolesToNotify = await this.getCommonService().getConfig(CONFIG_PARAMS.MODERATOR_ROLES, [SUPER_ADMIN_ROLE]);
      if (rolesToNotify.length > 0) {
        const emails = await strapi.query('admin::user')
                                   .findMany({ where: { roles: { code: rolesToNotify } } })
                                   .then((users) => users.map((user) => user.email));
        if (emails.length > 0) {
          const from = await strapi.query('admin::user').findOne({ where: { roles: { code: SUPER_ADMIN_ROLE } } });
          if (strapi.plugin('email')) {
            await strapi.plugin('email')
                        .service('email')
                        .send({
                          to: emails,
                          from: from.email,
                          subject: 'New abuse report on comment',
                          text: `
                        There was a new abuse report on your app. 
                        Reason: ${reason}
                        Message: ${content}
                    `,
                        });
          }
        }
      }
    },

    async markAsRemovedNested(commentId: string | number, status: boolean) {
      return this.getCommonService().modifiedNestedNestedComments(
        commentId,
        'removed',
        status,
      );
    },

    async sendResponseNotification(entity: Comment) {
      // Email notifications disabled to prevent timeout issues
      // If you want to re-enable email notifications for replies, 
      // make sure you have properly configured the email plugin
      return;
    },
  });
};

type ClientService = ReturnType<typeof clientService>;
export default clientService;
