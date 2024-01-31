<script lang="ts">
    //import "sanitize.css";
    import "../styles/global.css";

    import { solvedUrl } from "$lib/paging";
</script>


<header>
    <a class="titleLink" href={solvedUrl()}>
        <h2 class="title">Comline Playground</h2>
    </a>
</header>

<main>
    <nav class="tabsMenu">
        <a class="tabButton" href={solvedUrl("schema_editor")}>Quick Schema Editor</a>
        <a class="tabButton" href={solvedUrl("package_editor")}>Package Editor</a>
        <!--<a class="tabButton" href="/call_inspector">Call Inspector</a>-->
        <a class="tabButton" href={solvedUrl("unit_tests")}>Unit Tests</a>
        <a class="tabButton" href={solvedUrl("settings")}>Settings</a>  
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
        width: 100%;
        height: 100%;
        margin: 2px auto;
    }

    footer {
        text-align: center;
        color: #F2E1CA;
    }

    .titleLink {
        text-decoration: none;
    }
    .title {
        position: relative;
        display: flex;
    }
    .title:hover {
        color: #DBB594;
    }

    .tabsMenu {
        display: flex;
        justify-content: center;
        padding: 3pt;
        margin-bottom: 5pt;
        border-color: #4D3C2F;
        border-style: ridge;
        gap: 2pt;
    }
    .tabButton {
        width: 100%;
        text-align: center;
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
        width: 100%;
        height: 100%;
        border: ridge;
        border-color: #4D3C2F;
    }
</style>

