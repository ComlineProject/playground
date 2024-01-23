<script lang="ts">
    import hljs from 'highlight.js';
    import rust from 'highlight.js/lib/languages/rust';
    import lua from 'highlight.js/lib/languages/lua';
    
    // Here we register all languages that the editor should take as input and output
    hljs.registerLanguage('rust', rust);
    hljs.registerLanguage('lua', lua);
    
    // TODO: Make highlighters for Comline IDL and IDS
    // hljs.registerLanguage('rust', require('highlight.js/lib/languages/rust'));
    
    let highlightedCode = $state("")
    
    function highlightCode(): String {
        return hljs.highlightAuto(highlightedCode).value
    }

</script>

<p>Test editor</p>
<p on:input={highlightCode}>{highlightedCode}</p>

<style>

</style>
