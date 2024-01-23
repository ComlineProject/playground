<script lang="ts">
	// if you want to get themes, feel free to import exportedThemes, nativeThemes, or themeNames.
	import Monaco from 'svelte-monaco';

	// this is fully reactive! setting value to another string will change the editor accordingly
	let value = $state('const x = 5');
</script>

<div id="editor">
	<!-- event.detail is the monaco instance. All options are reactive! -->
	<Monaco
		options={{ language: 'rust', automaticLayout: true }}
		theme="vs-dark"
		on:ready={(event) => console.log(event.detail)}
		bind:value
	/>
</div>

<style>
    .editor {
        width: 100%;
        height: 100%;
    }
</style>