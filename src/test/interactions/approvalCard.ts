// DOM interaction + query helpers for the ToolApprovalInterrupt card.
// Scoped via `within(container)` so they work whether the card is rendered
// standalone in a component test or nested inside a full ChatInterface mount.

import { fireEvent, within } from "@testing-library/react";

export const findCardHeader = (scope: HTMLElement) =>
  within(scope).findByText(/approval required/i);

export const getToolName = (scope: HTMLElement) =>
  within(scope).getByText(/^Tool$/i).nextElementSibling as HTMLElement;

export const getApproveButton = (scope: HTMLElement) =>
  within(scope).getByRole("button", { name: /^(approve|approving)/i });

export const getRejectButton = (scope: HTMLElement) =>
  within(scope).getByRole("button", { name: /^reject/i });

export const getEditButton = (scope: HTMLElement) =>
  within(scope).getByRole("button", { name: /^edit/i });

export const getConfirmRejectButton = (scope: HTMLElement) =>
  within(scope).getByRole("button", { name: /confirm reject|rejecting/i });

export const getSaveApproveButton = (scope: HTMLElement) =>
  within(scope).getByRole("button", { name: /save.*approve|saving/i });

export const clickApprove = (scope: HTMLElement) =>
  fireEvent.click(getApproveButton(scope));

export const clickReject = (scope: HTMLElement) =>
  fireEvent.click(getRejectButton(scope));

export const clickEdit = (scope: HTMLElement) =>
  fireEvent.click(getEditButton(scope));

export const typeRejectionMessage = (scope: HTMLElement, message: string) => {
  const textarea = within(scope).getByPlaceholderText(
    /explain why you're rejecting/i
  );
  fireEvent.change(textarea, { target: { value: message } });
};

export const confirmReject = (scope: HTMLElement) =>
  fireEvent.click(getConfirmRejectButton(scope));

export const setEditedArg = (
  scope: HTMLElement,
  argKey: string,
  value: string
) => {
  const label = within(scope).getByText(argKey);
  const textarea = label.parentElement?.querySelector("textarea");
  if (!textarea) throw new Error(`no textarea found for arg "${argKey}"`);
  fireEvent.change(textarea, { target: { value } });
};

export const clickSaveApprove = (scope: HTMLElement) =>
  fireEvent.click(getSaveApproveButton(scope));
