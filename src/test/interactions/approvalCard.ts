// DOM interaction + query helpers for the ToolApprovalInterrupt card.
// Scoped via `within(container)` so they work whether the card is rendered
// standalone in a component test or nested inside a full ChatInterface mount.

import { fireEvent, within } from "@testing-library/react";

export const findCardHeader = (scope: HTMLElement) =>
  within(scope).findByText(/approval required/i);

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

// Uses the `aria-label="Rejection message"` on the textarea instead of the
// placeholder or a DOM-shape sibling walk. Robust across visual refactors.
export const typeRejectionMessage = (scope: HTMLElement, message: string) => {
  const textarea = within(scope).getByRole("textbox", {
    name: /rejection message/i,
  });
  fireEvent.change(textarea, { target: { value: message } });
};

export const confirmReject = (scope: HTMLElement) =>
  fireEvent.click(getConfirmRejectButton(scope));

// Uses the label/htmlFor association (label points at the card's uniquely
// prefixed `edit-arg` textarea id), so the query stays valid even if the
// surrounding DOM structure changes.
export const setEditedArg = (
  scope: HTMLElement,
  argKey: string,
  value: string
) => {
  const textarea = within(scope).getByLabelText(argKey);
  fireEvent.change(textarea, { target: { value } });
};

export const clickSaveApprove = (scope: HTMLElement) =>
  fireEvent.click(getSaveApproveButton(scope));
