import getApiURL from "../getApiUrl";

describe("getApiURL()", () => {
  it("should return valid URL", () => {
    expect(getApiURL("comments")).toEqual('/@3akram2/strapi-plugin-comments/comments');
  });
});
