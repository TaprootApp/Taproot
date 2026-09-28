import { rootClient } from "@rootsdk/client-app";
import type { IRootClient } from "@rootsdk/client-app";
import type { PostMessageRequest } from "@taproot/gen-shared";
import { contentServiceClient } from "@taproot/gen-client";

// Workarounds for generated client methods that don't behave like the rest.
//
// The generator emits Void-returning RPCs as fire-and-forget: the generated
// contentServiceClient.postMessage sends the request and resolves at once, so
// a server error (deleted channel, no permission to post) is lost. Sending
// through the same registered path with sendWithResponse waits for the reply
// and rejects with the server's RootServerException like every other RPC.

// Importing the client registers ContentService's paths with rootClient;
// referencing it keeps that import from being dropped as unused.
void contentServiceClient;

/** ContentService.PostMessage, resolving only once the server has posted. */
export function postMessage(request: PostMessageRequest): Promise<void> {
  // The generated code casts rootClient the same way to register itself.
  const client = rootClient as unknown as IRootClient;
  return client.sendWithResponse<PostMessageRequest, unknown>("/.ContentService/PostMessage", request).then(() => undefined);
}
