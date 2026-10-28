import { createSignal, For, Show, type Component } from "solid-js";
import type { EvalTableColumn } from "../../../chat/eval-details";

/** Rows drawn at first; a "more rows" button reveals the rest in steps, so a huge frame is not a huge DOM. */
const ROWS_SHOWN = 100;
const ROWS_STEP = 500;

/** A DataFrame or `console.table` an eval cell printed, as a table; numeric columns right-align. */
export const EvalTable: Component<{ columns: EvalTableColumn[]; rows: string[][] }> = (props) => {
	const [shown, setShown] = createSignal(ROWS_SHOWN);
	const hidden = () => Math.max(props.rows.length - shown(), 0);
	return (
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
					<For each={props.rows.slice(0, shown())}>
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
					<Show when={hidden() > 0}>
						<tr>
							<td colspan={props.columns.length}>
								<button
									type="button"
									class="eval-table-more"
									onClick={() => setShown(shown() + ROWS_STEP)}
								>
									{hidden()} more rows
								</button>
							</td>
						</tr>
					</Show>
				</tbody>
			</table>
		</div>
	);
};
