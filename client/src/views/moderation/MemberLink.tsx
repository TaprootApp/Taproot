import React from "react";
import { useNav } from "../../lib";

// Deep link to a member's detail on the Members page. Uses the shell's
// nav params: Members reads { userId, name } from useNav().params.

export const MemberLink: React.FC<{ userId: string; name: string }> = ({ userId, name }) => {
  const { navigate } = useNav();
  return (
    <button
      type="button"
      className="tp-link"
      title={userId}
      onClick={(e) => {
        // Rows may be clickable themselves.
        e.stopPropagation();
        navigate("members", { userId, name });
      }}
    >
      {name || "Unknown member"}
    </button>
  );
};

/** First letter of a name for the round placeholder avatar. */
export function initial(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toUpperCase() : "?";
}
