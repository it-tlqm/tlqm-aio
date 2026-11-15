export const attachmentFormats = ['pdf', 'png', 'jpeg', 'txt', 'csv', 'docx', 'xlsx'] as const;
export type AttachmentFormat = (typeof attachmentFormats)[number];
export const maxAttachmentBytes = 10 * 1024 * 1024;
export type AttachmentField = {
  formats: AttachmentFormat[];
  maxFiles: number;
  maxBytes: number;
};
export const defaultAttachmentField = (): AttachmentField => ({
  formats: [...attachmentFormats],
  maxFiles: 3,
  maxBytes: maxAttachmentBytes,
});
