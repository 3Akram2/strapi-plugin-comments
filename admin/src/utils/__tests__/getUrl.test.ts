import getUrl from "../getUrl";

describe("getUrl()", () => {
  it("should return valid URL", () => {
    expect(getUrl("comments")).toEqual('/plugins/@3akram2/strapi-plugin-comments/comments');
    expect(getUrl(undefined)).toEqual('/plugins/@3akram2/strapi-plugin-comments/');
  });
});
