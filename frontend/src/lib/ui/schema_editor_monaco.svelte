<script lang="ts">
	import Monaco, { themeNames } from 'svelte-monaco';

	let value = 'const x = 5';
	let readOnly = false;
	let theme = 'vs-dark';

	function selectTheme(themeSelection: string) {
		return () => {
			theme = themeSelection;
			window.scrollTo(0, 0);
		};
	}
</script>

	<div id="playground">
		<div id="editor">
			<Monaco
				options={{
					language: 'typescript',
					automaticLayout: true,
					readOnly
				}}
				{theme}
				bind:value
				on:ready={(editor) => {
					editor.detail.addAction({
						// An unique identifier of the contributed action.
						id: 'my-unique-id',

						// A label of the action that will be presented to the user.
						label: 'Custom Action',

						contextMenuGroupId: 'navigation',

						contextMenuOrder: 1.5,

						// Method that will be executed when the action is triggered.
						// @param editor The editor instance is passed in as a convenience
						run: function (ed) {
							alert("i'm running => " + ed.getPosition());
						}
					});
				}}
			/>
		</div>

		<textarea class="output" bind:value />
	</div>

    <!--
	<h2>Options</h2>
	<p>
		<b>NOTE</b>: Options can be any JSON object that is passed straight to monaco. This, for
		demonstartion, only shows the advanced theme option, and a readonly option.
	</p>

	<label>
		<input type="checkbox" bind:checked={readOnly} />
		readonly
	</label>

	<br />

	<p>Theme: <input type="text" bind:value={theme} /></p>

	<p>Available themes:</p>
	<div id="themes">
		{#each themeNames as buttonTheme}
			<button on:click={selectTheme(buttonTheme)} class:active={theme === buttonTheme}>
				{buttonTheme}
			</button>
		{/each}
	</div>
    -->

<style>
	main {
		margin: 2rem;
		width: calc(100% - 4rem);
		text-align: center;
	}

	div#editor {
		width: 50%;
		margin-right: 2rem;
		height: 100%;
		border: 1px solid black;
	}

    #playground {
		height: 60vh;
		width: 100%;
		display: flex;
		flex-direction: row;
		justify-content: space-between;
		text-align: left;
	}

	textarea {
		width: 50%;
		resize: none;
        background-color: #3E3128;
        color: white;
        border-color: #7C5F46;
        outline: none !important;

	}

	#themes {
		display: flex;
		flex-direction: row;
		justify-content: left;
		flex-wrap: wrap;
	}

	#themes button {
		margin: 0.5rem;
		background: white;
		border: 1px solid black;
		padding: 0.5rem;
	}

	#themes button.active {
		background: black;
		color: white;
	}
</style>
