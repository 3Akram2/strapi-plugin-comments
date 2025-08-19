const { default: clientService } = require('./server/dist/services/client.service');
const { buildAuthorModel } = require('./server/dist/services/utils/functions');

// Test the buildAuthorModel function directly
const testComment = {
  id: 1,
  content: "Test comment",
  authorId: "5",
  authorDocumentId: "doc123", 
  authorName: "John Privacy",
  authorUsername: "user_a_privacy_test",
  authorEmail: "user_a@privacytest.com",
  authorAvatar: null,
  createdAt: "2025-08-19T05:00:00.000Z"
};

const blockedAuthorProps = [];
const result = buildAuthorModel(testComment, blockedAuthorProps);

console.log('Input comment:', JSON.stringify(testComment, null, 2));
console.log('\nTransformed result:', JSON.stringify(result, null, 2));
console.log('\nAuthor object:', JSON.stringify(result.author, null, 2));
console.log('\nChecking for authorUsername in main comment:');
console.log('Has authorUsername?', 'authorUsername' in result);
console.log('authorUsername value:', result.authorUsername);