<script>
	import SchemaEditorMonaco from "$lib/ui/schema_editor_monaco.svelte";
	
	const editors = [
		{ id: "monaco", name: "Monaco (Microsoft)" },
		{ id: "ace", name: "Ace (Ajax.org C9, Amazon)" },
		{ id: "code_mirror", name: "Code Mirror (Marijn Haverbeke)" }
	];

</script>


<SchemaEditorMonaco/>


<div class="editor_box">
	<label for="pet-select">Current Editor:</label>

	<select name="editors" id="editor-select">
		{#each editors as editor}
			<option value="{editor.id}">{editor.name}</option>			
		{/each}
	</select>	
</div>


<style>
	.editor_box {
		border: ridge;
        border-color: #4D3C2F;
	}
	.editor_box select {
		margin: 2pt;
        background-color: #322922;
        color: #DBB594;
    	border-color: #4D3C2F;
	}
</style>