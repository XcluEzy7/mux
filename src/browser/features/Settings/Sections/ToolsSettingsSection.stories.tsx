import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import type { ToolsConfig } from "@/common/config/schemas";
import { ToolsSettingsSection } from "./ToolsSettingsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const TOOLS_STORY_CONFIG: ToolsConfig = {
  defaults: {
    mode: "allow_all_except",
    toolNames: ["bash", "file_edit_replace_string"],
  },
  custom: [
    {
      id: "workspace_search",
      label: "Workspace Search",
      command: "python",
      args: ["tool.py", "--scope", "workspace root"],
      instructions: "Search indexed workspace files for references.",
      provenance: {
        package: "@acme/workspace-search",
        links: ["https://github.com/acme/workspace-search"],
      },
      enabled: true,
    },
  ],
};

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ToolsSettingsSection",
  component: ToolsSettingsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ toolsConfig: TOOLS_STORY_CONFIG })}>
      <ToolsSettingsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByRole("heading", { name: /Tool access and registration/i });
    await canvas.findByRole("heading", { name: /Global defaults/i });
    await canvas.findByRole("heading", { name: /Custom tools/i });
    await canvas.findByDisplayValue('tool.py --scope "workspace root"');

    const toolNameChip = await canvas.findByText("bash");
    if (!toolNameChip) {
      throw new Error("Expected default tool chip for bash");
    }
  },
};

export const ArgValidation: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ toolsConfig: TOOLS_STORY_CONFIG })}>
      <ToolsSettingsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const argsInput = await canvas.findByDisplayValue('tool.py --scope "workspace root"');

    await userEvent.clear(argsInput);
    await userEvent.type(argsInput, 'tool.py "unterminated');

    await waitFor(async () => {
      await canvas.findByText(/Close all quoted arguments before saving/i);
    });

    const saveButton = await canvas.findByRole("button", { name: /Save tools settings/i });
    if (!(saveButton as HTMLButtonElement).disabled) {
      throw new Error("Save button should be disabled while args parsing has errors");
    }
  },
};
