export type LoginStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export type TokenFile = {
  bot_token: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  get_updates_buf?: string;
  saved_at: string;
  protocol_source: string;
};

export type QRCodeResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

export type QRStatusResponse = {
  status: LoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

export type MessageItem = {
  type?: number;
  text_item?: {
    text?: string;
  };
};

export type WeixinMessage = {
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  message_id?: number;
  seq?: number;
};

export type GetUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};
