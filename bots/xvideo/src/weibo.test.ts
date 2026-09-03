import assert from "node:assert/strict";
import test from "node:test";

import { extractWeiboId } from "shared/weibo";

test("extractWeiboId supports weibo.com short-id URLs", () => {
  assert.equal(extractWeiboId("https://weibo.com/1195908387/RfO2JFuk3"), "RfO2JFuk3");
  assert.equal(
    extractWeiboId("see https://weibo.com/1195908387/RfO2JFuk3?type=comment"),
    "RfO2JFuk3",
  );
});

test("extractWeiboId supports m.weibo.cn URLs", () => {
  assert.equal(extractWeiboId("https://m.weibo.cn/detail/5337672899888011"), "5337672899888011");
  assert.equal(extractWeiboId("https://m.weibo.cn/status/5337672899888011"), "5337672899888011");
});

test("extractWeiboId supports weibo.com/detail URLs", () => {
  assert.equal(extractWeiboId("https://weibo.com/detail/RfO2JFuk3"), "RfO2JFuk3");
});

test("extractWeiboId returns null for non-weibo URLs", () => {
  assert.equal(extractWeiboId("https://x.com/user/status/1234567890"), null);
  assert.equal(extractWeiboId("https://twitter.com/user/status/1234567890"), null);
  assert.equal(extractWeiboId("not a URL"), null);
});
