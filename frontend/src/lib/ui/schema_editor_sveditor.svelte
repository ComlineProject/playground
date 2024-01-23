<script>
    import Editor from 'sveditor'
    import hljs from 'highlight.js'
    /* Using github dark style */
    import 'highlight.js/styles/github-dark.css';
    // This function will be called
    // everytime the editor updates
    /**
	 * @param {{ detail: { output: HTMLElement; }; }} e
	 */
    function highlight(e) {
       // e.detail.output is the <code> element
       // that displays the processed text
       hljs.highlightElement(e.detail.output);
    }
 </script>
 
 <!-- 
    The out-class attr will be passed to the <code> element.
    We use here because highlight.js identifies the languages 
    by the class of the <code> element
 -->
 
 <Editor class="hljs" outputClass="javascript" fontSize="1.8rem" on:update={highlight}/>
 
 <style>
     :global(body) {
         margin: 0;
         display: flex;
     }
 
     main {
         width: 100vw;
         height: 100vh;
     }
 </style>
 