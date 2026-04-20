/**
 * Component to display the PR badge in the workspace header.
 * PR is detected from the workspace's current branch via `gh pr view`.
 */

import { useAPI } from "@/browser/contexts/API";
import { useWorkspacePR, useWorkspacePullRequestFeed } from "@/browser/stores/PRStatusStore";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { PRLinkBadge } from "../PRLinkBadge/PRLinkBadge";

interface WorkspaceLinksProps {
  workspaceId: string;
}

export function WorkspaceLinks({ workspaceId }: WorkspaceLinksProps) {
  const { api } = useAPI();
  const workspacePR = useWorkspacePR(workspaceId);
  const feed = useWorkspacePullRequestFeed(workspaceId);

  if (!workspacePR) {
    return null;
  }

  return (
    <PRLinkBadge
      prLink={workspacePR}
      feed={feed}
      onPushToFix={
        api
          ? async (startMessage) => {
              const result = await forkWorkspace({
                client: api,
                sourceWorkspaceId: workspaceId,
                startMessage,
                sendMessageOptions: getSendOptionsFromStorage(workspaceId),
              });
              if (!result.success) {
                throw new Error(result.error ?? "Failed to fork remediation workspace");
              }
            }
          : undefined
      }
    />
  );
}
