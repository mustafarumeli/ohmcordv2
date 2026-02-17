import React from "react";

export function VoiceRing(props: { speaking: boolean }) {
  return <span className={props.speaking ? "ring ringOn" : "ring"} />;
}

