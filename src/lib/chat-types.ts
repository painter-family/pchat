export type Language = "en" | "es";
export type Translation = { targetLanguage: Language; status: "pending" | "ready" | "failed"; text: string | null };
export type ChatUser = { id: string; name: string; email: string };
export type ChatSummary = {
  id: string;
  title: string;
  joined: boolean;
  owned?: boolean;
  updatedAt: number;
  lastMessage: string;
  inputLanguage?: Language;
  previewMessage?: ChatMessage;
};

export type UserView = { selectedChatId: string | null; revision: number; preferredLanguage?: Language };
export type ChatView = { inputLanguage?: Language; draft: string; draftRevision: number; anchorId: number | null; anchorOffset: number; revision: number };
export type ChatMessage = {
  id: number;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  sourceLanguage?: Language;
  translation?: Translation;
  createdAt: number;
  attachment: null | { id: string; name: string; mime: string; size: number };
};
