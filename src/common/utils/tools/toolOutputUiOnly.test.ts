import { describe, expect, it } from "bun:test";

import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

describe("getToolOutputUiOnly", () => {
  it("accepts ask_user_question answerSelections when null", () => {
    const uiOnly = getToolOutputUiOnly({
      ui_only: {
        ask_user_question: {
          questions: [],
          answers: {},
          answerSelections: null,
        },
      },
    });

    expect(uiOnly?.ask_user_question?.answerSelections).toBeNull();
  });

  it("rejects ask_user_question payload when answerSelections is an array", () => {
    const uiOnly = getToolOutputUiOnly({
      ui_only: {
        ask_user_question: {
          questions: [],
          answers: {},
          answerSelections: ["Implementation"],
        },
      },
    });

    expect(uiOnly).toBeUndefined();
  });
});
