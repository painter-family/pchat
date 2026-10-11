export type ChatUser = { id: string; name: string; email: string };
export type ChatSummary = {
  id: string;
  title: string;
  joined: boolean;
  updatedAt: number;
  lastMessage: string;
};
export type ChatMessage = {
  id: number;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  attachment: null | { id: string; name: string; mime: string; size: number };
};
