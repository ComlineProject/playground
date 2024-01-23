<script lang="ts">
    //import "sanitize.css";
    import "../styles/global.css";

    enum Tab {
        QuickSchemaEditor,
        PackageEditor,
        UnitTests,
        Settings
    }

    function onSwitchToSchemaTab(tab: Tab) {
        
    }
</script>


<header>
    <h2>Comline Playground</h2>
</header>

<main>
    <nav class="tabsMenu">
        <a class="tabButton" href="/schema_editor">Quick Schema Editor</a>
        <a class="tabButton" href="/package_editor">Package Editor</a>
        <!--<a class="tabButton" href="/call_inspector">Call Inspector</a>-->
        <a class="tabButton" href="/schema_editor">Unit Tests</a>

        <a class="tabButton" href="/schema_editor">Settings</a>  
    </nav>

    <div class="tab">
        <slot/>
    </div>
</main>

<footer>
    Made with bread and smoothies
</footer>


<style>
    header {
        display: flex;
        justify-content: center;
        margin-top: 1pt;
        margin-bottom: 1pt;
        
        border-style: ridge;
        border-color: #614A39;
    }

    main {
        margin: 2px auto;
    }

    footer {
        text-align: center;
        color: #F2E1CA;
    }

    .title {
        position: relative;
        display: flex;
        border-color: #614A39;
        border-style: ridge;
        margin-bottom: 1pt;
    }
    .tabsMenu {
        display: flex;
        justify-content: center;
        padding: 3pt;
        margin-bottom: 5pt;
        border-color: #4D3C2F;
        border-style: ridge;

    }
    .tabButton {
        padding: 10px 20px;
        cursor: pointer;
        text-decoration: none;
        background-color: #322922;
        color: #DBB594;
        border-color: #4D3C2F;
        border-style: ridge;
    }
    .tabButton:hover {
        background-color: #3E3128;
    }
    .tabButton:active {
        background-color: #28211D;
    }
    .tab {
        border: ridge;
        border-color: #4D3C2F;
    }
</style>

