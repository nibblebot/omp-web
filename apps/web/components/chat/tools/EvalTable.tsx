import { For, type Component } from "solid-js";
import type { EvalTableColumn } from "../../../chat/eval-details";

/** A DataFrame or `console.table` an eval cell printed, as a table; numeric columns right-align. */
export const EvalTable: Component<{ columns: EvalTableColumn[]; rows: string[][] }> = (props) => (
	<div class="eval-table-scroll">
		<table class="eval-table">
			<thead>
				<tr>
					<For each={props.columns}>
						{(column) => (
							<th scope="col" classList={{ "eval-table-numeric": column.numeric }}>
								{column.head}
							</th>
						)}
					</For>
				</tr>
			</thead>
			<tbody>
				<For each={props.rows}>
					{(row) => (
						<tr>
							<For each={row}>
								{(cell, i) => (
									<td classList={{ "eval-table-numeric": props.columns[i()]?.numeric === true }}>
										{cell}
									</td>
								)}
							</For>
						</tr>
					)}
				</For>
			</tbody>
		</table>
	</div>
);
