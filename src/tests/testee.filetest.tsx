import React, {
  useRef, 
  useState, 
  useEffect, 
  use as u
} from "react";
import {useQuery, List, Stack} from "#datacore";
import {aThing} from "tree-table-maybe";
export async function hi() {
  useRef(useQuery("@task and !$completed"))
  const thing = useQuery("@task");
  const spread = {
    ...(await dc.require("another-thing")), 
    thing
  }
  const importList = (<List/>)
  return (<Stack>
		<div>hi</div>
	</Stack>);
}
export const idk = "bye";
export * as fuck from "whatthefuck";
export * from "anotherfucker";
export {u as v};
export {aThing}
export default function(arg) {
  console.log(`hi, ${arg ?? "theo"}!!`)
}
